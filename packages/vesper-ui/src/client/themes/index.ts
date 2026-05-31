// Importing this barrel registers every built-in theme into the THEME_REGISTRY.
// Add a new theme by importing its module here (it self-registers on import).
// Order matters: the LAST module passing `default: true` wins, so "glass" (the
// premium light-glass surface) is the default; hearth stays at ?theme=hearth.
import "./hearth/theme.ts";
import "./glass/theme.ts";
