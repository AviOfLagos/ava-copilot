#!/usr/bin/env node
/**
 * Puts the on-device "Hey Ava" listener's files in public/wake/ (git-ignored, about 45 MB):
 *
 * - vosk-worker.js: the Vosk speech recogniser (vosk-browser 0.0.8, Apache-2.0), taken out of the
 *   blob worker it ships as (extension pages may not start blob workers) and made eval-free (they may
 *   not run `new Function` either), using Emscripten's own non-eval forms of the three embind helpers.
 * - model.tar.gz: vosk-model-small-en-us-0.15 (Apache-2.0), repacked from zip to the tar.gz Vosk reads.
 *
 * Both downloads are checked against pinned SHA-256 sums. Run: node scripts/wake-word-setup.mjs
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../public/wake');
const SOURCES = {
  worker: {
    url: 'https://registry.npmjs.org/vosk-browser/-/vosk-browser-0.0.8.tgz',
    sha256: 'fd16fc7e64c935d7a79cf07c8f67d84232b6485376a59144af8a234979a9a4b4',
  },
  model: {
    url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',
    sha256: '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498',
  },
};

async function download({ url, sha256 }, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sum = createHash('sha256').update(bytes).digest('hex');
  if (sum !== sha256) throw new Error(`${url}: checksum ${sum} is not the pinned ${sha256}`);
  fs.writeFileSync(file, bytes);
}

/** Replaces one whole function declaration, found by name, with another. */
function replaceFunction(source, name, replacement) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let at = source.indexOf('{', start); at < source.length; at++) {
    if (source[at] === '{') depth++;
    else if (source[at] === '}' && --depth === 0) return source.slice(0, start) + replacement + source.slice(at + 1);
  }
  throw new Error(`function ${name} has no end`);
}

// Emscripten's DYNAMIC_EXECUTION=0 forms: the same behaviour, without building code from strings
const NO_EVAL = {
  createNamedFunction: `function createNamedFunction(name,body){return function(){"use strict";return body.apply(this,arguments)}}`,
  craftInvokerFunction: `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var expected=argCount-2;return function(){if(arguments.length!==expected){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expected+" args!")}var destructors=needsDestructorStack?[]:null;var thisWired;var wired=[];var invokerArgs=[cppTargetFunc];if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);invokerArgs.push(thisWired)}for(var i=0;i<expected;++i){wired[i]=argTypes[i+2].toWireType(destructors,arguments[i]);invokerArgs.push(wired[i])}var rv=cppInvokerFunc.apply(null,invokerArgs);if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var param=i===1?thisWired:wired[i-2];if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(param)}}}if(returns){return argTypes[0].fromWireType(rv)}}}`,
  __emval_get_method_caller: `function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var invokerFunction=function(handle,name,destructors,args){var offset=0;var list=new Array(argCount-1);for(var i=0;i<argCount-1;++i){list[i]=types[i+1].readValueFromPointer(args+offset);offset+=types[i+1]["argPackAdvance"]}var rv=handle[name].apply(handle,list);for(var i=0;i<argCount-1;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(list[i])}}if(!retType.isVoid){return retType.toWireType(destructors,rv)}};return __emval_addMethodCaller(invokerFunction)}`,
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-'));
  try {
    console.log('Downloading the recogniser…');
    await download(SOURCES.worker, path.join(work, 'vosk.tgz'));
    execFileSync('tar', ['xzf', 'vosk.tgz'], { cwd: work });
    const bundle = fs.readFileSync(path.join(work, 'package/dist/vosk.js'), 'utf8');
    const base64 = /createBase64WorkerFactory\('([A-Za-z0-9+/=]+)'/.exec(bundle)?.[1];
    if (!base64) throw new Error('The worker was not found in vosk.js');
    const source = Buffer.from(base64, 'base64').toString('latin1');
    // The loader drops the first line, a comment from the bundler, the same way
    let worker = source.slice(source.indexOf('\n', 10) + 1);
    for (const [name, replacement] of Object.entries(NO_EVAL)) worker = replaceFunction(worker, name, replacement);
    if (/new Function|new_\(Function|\beval\(/.test(worker))
      throw new Error('The worker still builds code from strings');
    fs.writeFileSync(path.join(OUT, 'vosk-worker.js'), worker, 'latin1');

    console.log('Downloading the English model (40 MB)…');
    await download(SOURCES.model, path.join(work, 'model.zip'));
    execFileSync('unzip', ['-q', 'model.zip'], { cwd: work });
    // Without macOS's ._ metadata files, which would be unpacked as model files
    execFileSync('tar', ['czf', path.join(OUT, 'model.tar.gz'), 'vosk-model-small-en-us-0.15'], {
      cwd: work,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    console.log(`Done: ${OUT}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
