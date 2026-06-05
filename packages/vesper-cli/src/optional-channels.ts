/**
 * Lazy registration of OPT-IN channel plugins that live in separate packages, so
 * `@vesper/core` and `@vesper/cli` stay statically dependency-free of heavy/optional
 * channel SDKs. The daemon calls this once at boot; a package that is not installed
 * (or fails to load) is simply skipped and its channel stays `available: false`.
 *
 * WhatsApp-Web (Baileys) is the first such package. The dynamic import uses a VARIABLE
 * specifier on purpose: it keeps the package out of the static module graph (tsc + the
 * compiled-binary bundler), so the heavy dependency is pulled in ONLY when present.
 */

import { type ChannelPlugin, registerChannelPlugin } from "@vesper/core";

/** Optional channel packages to attempt to load, by module specifier + export name. */
const OPTIONAL_CHANNELS: ReadonlyArray<{ readonly spec: string; readonly exportName: string }> = [
  { spec: "@vesper/channel-whatsapp-web", exportName: "whatsappWebPlugin" },
];

/** Best-effort: register every installed optional channel plugin. Never throws. */
export async function loadOptionalChannels(): Promise<readonly string[]> {
  const registered: string[] = [];
  for (const { spec, exportName } of OPTIONAL_CHANNELS) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      const plugin = mod[exportName];
      if (isChannelPlugin(plugin)) {
        registerChannelPlugin(plugin);
        registered.push(plugin.id);
      }
    } catch {
      // Package not installed or failed to load — the channel stays unavailable. Fine.
    }
  }
  return registered;
}

/** Narrow an unknown module export to a {@link ChannelPlugin} (id + build factory). */
function isChannelPlugin(value: unknown): value is ChannelPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { build?: unknown }).build === "function"
  );
}
