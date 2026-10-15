//! Adapter from authenticated, approved XPC frames to the existing NDJSON route.
use crate::{config::EngineConfig, connection, engine::Engine, sessions::Sessions};
use senpi_desktop_core::{methods::Method, types::DesktopSessionOptions};
use senpi_desktop_session::{BackendSelection, SessionTimeouts};
use senpi_desktop_xpc::{AgentTransport, Incoming};
use std::sync::Arc;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    task::JoinSet,
};

pub(crate) async fn run(name: &str) -> Result<(), String> {
    let latch = crate::stop_latch::StopLatch::open().map_err(|error| error.to_string())?;
    let sessions = Arc::new(Sessions::persistent(latch));
    #[cfg(test)]
    println!("XPC_TEST_READY stopped={}", sessions.stopped_before_connection());
    let transport = AgentTransport::start(name).map_err(|error| error.to_string())?;
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            stream = transport.next() => {
                let Some(stream) = stream else { break; };
                let sessions = Arc::clone(&sessions);
                tasks.spawn(async move { serve(stream, sessions).await });
            }
            joined = tasks.join_next(), if !tasks.is_empty() => {
                if let Some(Err(error)) = joined {
                    eprintln!("senpi-desktop-engine: XPC session task failed: {error}");
                }
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}

async fn serve(stream: Incoming, sessions: Arc<Sessions>) {
    let stream = Arc::new(stream);
    let first = loop {
        let Some(frame) = stream.receive().await else {
            return;
        };
        let Ok(method) = sessions.classify(&frame) else {
            return;
        };
        let Ok(request) = connection::parse_request(&frame) else {
            return;
        };
        match method {
            Method::EngineHello => {
                if let Some(id) = request.id {
                    let line = crate::rpc::reply_line(id, crate::rpc::to_result(Engine::hello()));
                    if stream.send(line.as_bytes()).is_err() {
                        return;
                    }
                }
            }
            Method::SessionOpen => {
                let params = if request.params.is_null() {
                    serde_json::json!({})
                } else {
                    request.params
                };
                if serde_json::from_value::<DesktopSessionOptions>(params).is_err() {
                    return;
                }
                break frame;
            }
            _ => return,
        }
    };
    // This point can only be reached after O1, finite authorization, the bound
    // capability/sequence and a valid session.open. No environment-selected backend.
    let config = EngineConfig {
        #[cfg(not(test))]
        selection: BackendSelection::Platform,
        #[cfg(test)]
        selection: BackendSelection::FakeScenario(Box::default()),
        timeouts: SessionTimeouts::default(),
        fake_clock: false,
    };
    let engine = match sessions.open(config) {
        Ok(engine) => engine,
        Err(_) => return,
    };
    let (engine_io, transport_io) = tokio::io::duplex(2 * 1024 * 1024);
    let (reader, writer) = tokio::io::split(engine_io);
    let (outgoing, mut incoming) = tokio::io::split(transport_io);
    let input_stream = Arc::clone(&stream);
    let input = async move {
        let mut frame = first;
        loop {
            if sessions.classify(&frame).is_err() {
                input_stream.close();
                return;
            }
            if incoming.write_all(&frame).await.is_err() || incoming.write_all(b"\n").await.is_err()
            {
                input_stream.close();
                return;
            }
            let Some(next) = input_stream.receive().await else {
                return;
            };
            frame = next;
        }
    };
    let output_stream = Arc::clone(&stream);
    let output = async move {
        let mut outgoing = BufReader::new(outgoing);
        let mut line = String::new();
        loop {
            line.clear();
            match outgoing.read_line(&mut line).await {
                Ok(0) | Err(_) => {
                    output_stream.close();
                    return;
                }
                Ok(_) => {
                    if output_stream.send(line.trim_end().as_bytes()).is_err() {
                        output_stream.close();
                        return;
                    }
                }
            }
        }
    };
    let routed = connection::serve_session_connection(Arc::clone(&engine), reader, writer);
    let (_, _, result) = tokio::join!(input, output, routed);
    if let Err(error) = result {
        eprintln!("senpi-desktop-engine: XPC session transport ended: {error}");
    }
    engine.shutdown().await;
}
