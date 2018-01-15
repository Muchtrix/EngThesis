'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const vscode_1 = require("vscode");
const vscode_languageclient_1 = require("vscode-languageclient");
function activate(context) {
    // lokalizacja modułu Node.js serwera
    let serverModule = context.asAbsolutePath(path.join('server', 'server.js'));
    // ustawienia umożliwiające debugowanie kodu serwera
    let debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };
    // ustawienia serwera
    let serverOptions = {
        run: { module: serverModule, transport: vscode_languageclient_1.TransportKind.ipc },
        debug: { module: serverModule, transport: vscode_languageclient_1.TransportKind.ipc, options: debugOptions }
    };
    // opcje klienta
    let clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'lua' }],
        synchronize: {
            configurationSection: 'lua-lang',
            fileEvents: vscode_1.workspace.createFileSystemWatcher('**/.clientrc')
        }
    };
    // Uruchomienie klienta LSP
    let client = new vscode_languageclient_1.LanguageClient('luaLanguage', 'Lua language extension', serverOptions, clientOptions).start();
    // Dodanie klienta do kolekcji elementów usuwanych przy zamknięciu rozszerzenia
    context.subscriptions.push(client);
}
exports.activate = activate;
//# sourceMappingURL=extension.js.map