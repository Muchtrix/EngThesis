'use strict';

import * as path from 'path';

import { workspace, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient';

export function activate(context: ExtensionContext) {

	// lokalizacja modułu Node.js serwera
	let serverModule = context.asAbsolutePath(path.join('server', 'server.js'));
	// ustawienia umożliwiające debugowanie kodu serwera
	let debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };
	
	// ustawienia serwera
	let serverOptions: ServerOptions = {
		run : { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	}
	
	// opcje klienta
	let clientOptions: LanguageClientOptions = {
		documentSelector: [{scheme: 'file', language: 'lua'}],
		synchronize: {
			configurationSection: 'lua-lang',
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	}
	
	// Uruchomienie klienta LSP
	let client = new LanguageClient('luaLanguage', 'Lua language extension', serverOptions, clientOptions).start();
	
	// Dodanie klienta do kolekcji elementów usuwanych przy zamknięciu rozszerzenia
	context.subscriptions.push(client);
}
