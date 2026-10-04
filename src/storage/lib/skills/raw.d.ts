// Vite imports a file's text with the ?raw suffix; the built-in skills are Markdown files read this way
declare module '*.md?raw' {
  const content: string;
  export default content;
}
