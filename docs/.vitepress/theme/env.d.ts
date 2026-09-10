// Vite resolves a CSS side-effect import at build time; TypeScript needs to be
// told the module shape exists, or `import './custom.css'` reads as a missing
// module in the editor while the build is fine.
declare module '*.css';
