// The app files the site imports are type-checked with the site; one of them (the composer's speech hook, imported
// for its types only) mentions the extension API. Nothing on the site calls it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;
