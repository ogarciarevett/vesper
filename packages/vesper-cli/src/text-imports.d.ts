// Ambient declaration for `import x from "....txt" with { type: "text" }`.
// The desktop build (scripts/build-daemon.ts) generates the referenced `.txt` files
// just before `bun build --compile`; this keeps the compiled-entry type-clean in a
// plain source checkout where those generated files are absent.
declare module "*.txt" {
  const content: string;
  export default content;
}
