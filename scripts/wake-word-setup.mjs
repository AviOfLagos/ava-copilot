#!/usr/bin/env node
/**
 * Puts the on-device "Hey Ava" listener's model in public/wake/ (git-ignored, about 41 MB) for a dev build. The
 * extension downloads the same pinned zip on first use when the wake word is turned on (see
 * src/shared/lib/voice-models/catalog.ts), so a normal install does not need this.
 *
 * - model.tar.gz: vosk-model-small-en-us-0.15 (Apache-2.0), repacked from zip to the tar.gz Vosk reads.
 *
 * - words.txt: the model's vocabulary, one word per line, read from the symbol table inside its
 *   graph/Gr.fst. The panel and background use it to tell whether "hey <assistant name>" can be the
 *   wake phrase: Vosk silently drops grammar words it does not know.
 *
 * The recogniser itself, public/vosk/vosk-worker.js, is code, so it is packed with the extension and kept in git
 * (an extension may not run code it downloads): the Vosk speech recogniser (vosk-browser 0.0.8, Apache-2.0), taken
 * out of the blob worker it ships as (extension pages may not start blob workers) and made eval-free (they may not
 * run `new Function` either), using Emscripten's own non-eval forms of the three embind helpers, with a prelude that
 * reads the model from the downloaded copy when there is one. `--worker` rebuilds only that file.
 *
 * Both downloads are checked against pinned SHA-256 sums. Run: node scripts/wake-word-setup.mjs
 * (`--words` writes only words.txt, from a model.tar.gz already in place.)
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(import.meta.dirname, '../public/wake');
const WORKER_OUT = path.resolve(import.meta.dirname, '../public/vosk/vosk-worker.js');
export const SOURCES = {
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

// Runs before the recogniser: the model URL it is given (wake/model.tar.gz) is answered from the copy the extension
// downloaded on first use (OPFS voice-models/vosk/, once its .ready.json is there), else from the package
export const OPFS_PRELUDE = `// Nex Copilot: wake/model.tar.gz from the model downloaded on first use, when there is one (data, never code)
(function () {
  var packed = self.fetch.bind(self);
  self.fetch = function (input, init) {
    var url = String(input && input.url ? input.url : input);
    var match = /^chrome-extension:\\/\\/[^/]+\\/wake\\/(model\\.tar\\.gz)$/.exec(url);
    var storage = self.navigator && self.navigator.storage;
    if (!match || !storage || !storage.getDirectory) return packed(input, init);
    return storage
      .getDirectory()
      .then(function (root) { return root.getDirectoryHandle('voice-models'); })
      .then(function (dir) { return dir.getDirectoryHandle('vosk'); })
      .then(function (dir) {
        return dir.getFileHandle('.ready.json').then(function () { return dir.getFileHandle(match[1]); });
      })
      .then(function (handle) { return handle.getFile(); })
      .then(
        function (file) { return new Response(file, { headers: { 'Content-Length': String(file.size) } }); },
        function () { return packed(input, init); }
      );
  };
})();
`;

const MODEL_DIR = 'vosk-model-small-en-us-0.15';
// OpenFst's symbol table magic number, which starts the word list embedded in Gr.fst
const SYMBOL_TABLE_MAGIC = 2125658996;

/** The words in an OpenFst binary file's first embedded symbol table, without the special ones. */
function readSymbolTable(bytes) {
  const magic = Buffer.alloc(4);
  magic.writeInt32LE(SYMBOL_TABLE_MAGIC);
  let at = bytes.indexOf(magic);
  if (at < 0) throw new Error('No word list in the model graph');
  at += 4;
  const nameLength = bytes.readInt32LE(at);
  at += 4 + nameLength + 8; // name, then the next free key
  const size = Number(bytes.readBigInt64LE(at));
  at += 8;
  const words = [];
  for (let i = 0; i < size; i++) {
    const length = bytes.readInt32LE(at);
    at += 4;
    words.push(bytes.toString('utf8', at, at + length));
    at += length + 8; // the word, then its key
  }
  return words.filter(word => !/^(<.*>|#\d+|!SIL|\[unk\])$/.test(word));
}

/** Writes words.txt from the model archive. */
function writeVocabulary() {
  const graph = execFileSync('tar', ['xzOf', path.join(OUT, 'model.tar.gz'), `${MODEL_DIR}/graph/Gr.fst`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const words = readSymbolTable(graph);
  fs.writeFileSync(path.join(OUT, 'words.txt'), `${words.join('\n')}\n`);
  console.log(`Vocabulary: ${words.length} words`);
}

/** The recogniser: vosk-browser's worker, out of its blob wrapper, eval-free, with the prelude. */
async function writeWorker(work) {
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
  if (/new Function|new_\(Function|\beval\(/.test(worker)) throw new Error('The worker still builds code from strings');
  fs.mkdirSync(path.dirname(WORKER_OUT), { recursive: true });
  fs.writeFileSync(WORKER_OUT, OPFS_PRELUDE + worker, 'latin1');
}

async function main() {
  if (process.argv.includes('--words')) {
    writeVocabulary();
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-'));
  try {
    if (process.argv.includes('--worker')) {
      await writeWorker(work);
      console.log(`Done: ${WORKER_OUT}`);
      return;
    }
    fs.mkdirSync(OUT, { recursive: true });
    console.log('Downloading the English model (41 MB)…');
    await download(SOURCES.model, path.join(work, 'model.zip'));
    execFileSync('unzip', ['-q', 'model.zip'], { cwd: work });
    // Without macOS's ._ metadata files, which would be unpacked as model files
    execFileSync('tar', ['czf', path.join(OUT, 'model.tar.gz'), MODEL_DIR], {
      cwd: work,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    writeVocabulary();
    console.log(`Done: ${OUT}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Run as a script (also from install.sh's copy); imported by the tests that compare it with the extension's list
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
