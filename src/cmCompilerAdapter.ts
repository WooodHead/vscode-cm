'use strict';

import { cmConfig } from './cmConfig';
import { cmOutputChannel } from './cmOutputChannel';
import vscode = require('vscode');
import { workspace } from 'vscode';

var compilerContainer = require("node-cm/index.js");

export class cmCompilerAdapter {
    
    private channel: cmOutputChannel;
    private filePath: string;
    private compiler;
    private isStarted: boolean = false;
    private diagnostics: vscode.DiagnosticCollection;
    
    constructor( diagnostics: vscode.DiagnosticCollection, filePath: string ) {
        this.filePath = filePath;
        this.channel = new cmOutputChannel( diagnostics, filePath );
        this.diagnostics = diagnostics;
        
        this.compiler = new compilerContainer( {
            cmRoot: cmConfig.cmRoot(),
            onRead: (data) => {
                this.channel.write( data );
            },
            onError: (data) => {
                vscode.window.showInformationMessage( "Error from CM Process" );
                this.channel.write( `[INFO: CM_Process_Error -> ${data}]` );
            },
            //debug: true,
            "cmArch": cmConfig.arch()
        });
    }

    public reset() {
        this.compiler.kill();

        this.compiler = new compilerContainer( {
            cmRoot: cmConfig.cmRoot(),
            onRead: (data) => {
                this.channel.write( data );
            },
            onError: (data) => {
                vscode.window.showInformationMessage( "Error from CM Process" );
                this.channel.write( `[INFO: CM_Process_Error -> ${data}]` );
            },
            //debug: true,
            "cmArch": cmConfig.arch()
        });
        this.clearOutputIfNeeded();
        this.isStarted = false;
        return this.start();
    }
    
    public startWritingOutputFile() : void {
        this.channel.write( `[Contents of output channel will now be written to: ${this.filePath}]\n` );
        this.channel.writeOutputToFile = true;
    }
    
    public stopWritingOutputFile() : void {
        this.channel.writeOutputToFile = false;
        this.channel.write( "[Stopped writing output to file]\n" );
    }
    
    public start() : Thenable<boolean> {
        if ( this.isStarted ) return;
        
        return new Promise((resolve, reject) => {
            this.compiler.start()
            .then( (success) => {
                this.isStarted = success;
                resolve(success);  
            }, reject);
        });        
    }
    
    public clean() {
        this.clearOutputIfNeeded();
        var results = this.compiler.clean();
        this.channel.write( "[INFO make clean-cm:]\n" );
        this.channel.write( "---------------------\n" );
        this.channel.write( results );
        this.channel.write( "---------------------\n" );
        this.channel.write( "[INFO CM Clean]\n" );
        this.isStarted = false;
    }
    
    public stop() {
        if ( !this.isStarted ) return;
        this.clearOutputIfNeeded();
        this.channel.write( "[INFO CM Killed]\n" );
        this.compiler.kill();
        this.isStarted = false;
    }
    
    public loadAllKnown( file: string ) {
        this.diagnostics.clear();
        this.startIfNotStarted().then( (succuess) => {
        //    this.compiler.write( "use cm.rs; updateParsedRs();" );
            console.log(file);
            this.compiler.write(`loadAll("${file.replace(/\\/g, "/")}");`);
        });
    }

    public compileWorkspace() {
        this.startIfNotStarted().then( (succuess) => {
            cmConfig.currentWorkspace()
            .then( path => {
                path = path.replace( /\\/g, "/" ) + "/";
                this.run( `{ use cm.runtime.util; compileAllBelow(CompileAllEnv("${path}")); }` );
            })
            // const path = cmConfig.currentWorkspace()
            
        } );
    }

    public compileVSWorkspace() {
        this.startIfNotStarted().then( (succuess) => {
            var command = "";
            workspace.workspaceFolders.forEach( wf => {
                let path = wf.uri.fsPath.replace( /\\/g, "/" ) + "/";
                command += `compileAllBelow(CompileAllEnv("${path}"));`;
            });
            this.run( `{ use cm.runtime.util; ${command} }` );
        } );
    }
    
    public compileFile( file: string ) {
        this.clearOutputIfNeeded();
        this.diagnostics.clear();
        this.startIfNotStarted().then((success) => {
            this.compiler.compileFile( file );
        });    
    }

    public runStatement( statement: CodeStatement ): Thenable<boolean> {
        if ( !statement.start && !this.isStarted ) return;
        this.clearOutputIfNeeded( statement.doNotClear );
        return this.startIfNotStarted()
        .then( (success) => {
            var promise = new Promise<boolean>( (res, rej) => { 
                this.channel.addOutputWatch( 
                    res, 
                    rej, 
                    statement.successEx,
                    statement.failureEx );
                this.compiler.write( statement.code );
                setTimeout( () => {
                    this.channel.clearOutputWatch();
                }, 2000 ); // give CM 2 seconds to respond 
            });
            
            return promise;
        });
    }
    
    public runIfStarted( cmCode: string ) {
        this.clearOutputIfNeeded();
        this.diagnostics.clear();
        if ( this.isStarted ) {
            this.compiler.write( cmCode );
        }
    }

    public run( cmCode: string ) {
        this.clearOutputIfNeeded();
        this.diagnostics.clear();
        this.startIfNotStarted().then((success) => {
            this.compiler.write( cmCode );
        });
    }
    
    public runCurrentFile( file: string ) {
        if ( !file.endsWith("acloader.cm") ) this.clearOutputIfNeeded();
        this.diagnostics.clear();
        this.startIfNotStarted().then((success) => {
            this.compiler.runFile( file );
        });
    }
    
    public quitDebug() {
        if(!this.isStarted) return;
        
        this.compiler.quitDebug();
    }
    
    public goto( file: string, offset: number ): Thenable<vscode.Location> {
        return this.startIfNotStarted()
        .then( (success) => {
            var promise = this.channel.goToDefinitionPromise();
            file = file.replace( /\\/g, '/' ); // make sure we have the right slashses        
            this.compiler.write( `cm.runtime.refers("${file}", ${offset});` );
            return promise;    
        });

    }
    
    private startIfNotStarted() : Thenable<boolean> {
        if(this.isStarted) 
            return new Promise((resolve, reject) => { resolve(true); });
        
        return this.start();
    }

    private clearOutputIfNeeded( skip = false ) {
        if ( skip ) return;
        if ( cmConfig.clearOutputOnBuild() ) {
            this.channel.clear();
        }
    }
}

export interface CodeStatement {
    // should start compiler if not started
    start: boolean; 
    // code to execute
    code: string;
    // regex to match for "success"
    successEx: RegExp;
    // regex to match for "failure"
    failureEx: RegExp;
    // should clear output
    doNotClear: boolean;
}