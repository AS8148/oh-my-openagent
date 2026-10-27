import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A synthetic PKI made per run with the OpenSSL CLI in a test-owned directory. No machine trust store is read. */
export type PkiCertificate = { readonly name: string; readonly der: Uint8Array; readonly key: string; readonly cert: string }

const CONFIG = `[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[ca_server]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[issued_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`

export class SyntheticPki {
  readonly dir = mkdtempSync(join(tmpdir(), "omo-windows-trust-"))
  readonly #config = join(this.dir, "openssl.cnf")
  #serial = 1

  constructor() {
    writeFileSync(this.#config, CONFIG)
  }

  #openssl(args: readonly string[]): void {
    // MSYS builds of openssl rewrite "/CN=..." into a path unless argument conversion is off.
    execFileSync("openssl", args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*", OPENSSL_CONF: this.#config },
    })
  }

  #load(name: string): PkiCertificate {
    const cert = join(this.dir, `${name}.pem`)
    const body = readFileSync(cert, "utf8").replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "")
    return { name, der: new Uint8Array(Buffer.from(body, "base64")), key: join(this.dir, `${name}.key`), cert }
  }

  root(name: string): PkiCertificate {
    this.#openssl(["req", "-config", this.#config, "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-subj", `/CN=omo synthetic ${name}`, "-days", "30", "-extensions", "ca",
      "-set_serial", String(this.#serial++), "-keyout", join(this.dir, `${name}.key`), "-out", join(this.dir, `${name}.pem`)])
    return this.#load(name)
  }

  issued(name: string, issuer: PkiCertificate, extensions: "issued_ca" | "ca_server" = "issued_ca"): PkiCertificate {
    const csr = join(this.dir, `${name}.csr`)
    this.#openssl(["req", "-config", this.#config, "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-subj", `/CN=omo synthetic ${name}`, "-keyout", join(this.dir, `${name}.key`), "-out", csr])
    this.#openssl(["x509", "-req", "-in", csr, "-CA", issuer.cert, "-CAkey", issuer.key, "-days", "30",
      "-set_serial", String(this.#serial++), "-extfile", this.#config, "-extensions", extensions, "-out", join(this.dir, `${name}.pem`)])
    return this.#load(name)
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}
