# SCG Shop ERP client (Tauri v2)

Installed on **client machines** only. It shows a connect screen (`ui/index.html`),
then navigates its webview to the main machine's web UI. All data and logic stay on
the main machine.

| Command (Rust) | JS call from the web UI | State |
| --- | --- | --- |
| `discover_main` | `__TAURI__.core.invoke('discover_main')` | Implemented with `mdns-sd` (browses `_scgerp._tcp.local.` for 2 s). Returns `[]` until the server advertises that service (server-side TODO). |
| `print_receipt` | `__TAURI__.core.invoke('print_receipt', { printerName, escposBytes })` | Implemented with winspool RAW printing. **Never run against a real printer.** |

Tauri maps camelCase JS argument names to the snake_case Rust parameters.

## Build

Windows only (`bundle.targets = ["nsis"]`):

```powershell
cd apps/desktop
npx --yes @tauri-apps/cli@2.12.4 build
# -> src-tauri/target/release/bundle/nsis/SCG Shop ERP_0.1.0_x64-setup.exe
```

The release workflow does this. `cargo check` does not work in a Linux container
without webkit2gtk/gtk3 dev packages.

## Known gaps

- **Self-signed TLS.** WebView2 rejects the main machine's self-signed certificate.
  The fix still to build: during pairing, import the main machine's CA certificate
  into the client's `CurrentUser\Root` store, or have the installer do it.
- **`/pair` endpoint.** The connect screen goes to `https://<host>:<port>/pair?code=NNNNNN`.
  The server has to implement this route: check the code, set a device cookie, redirect.
- **Remote IPC scope.** `capabilities/main-machine.json` allows IPC from any HTTPS
  origin, because the main machine's address is only known at runtime. After pairing,
  narrow this to the paired origin with `AppHandle::add_capability`.
- **No reconnect/offline screen.** If the main machine is down, the webview shows its
  own error page.
