/**
 * Drop non-file entries from TypeDoc's media registry before render.
 *
 * Package READMEs cross-link each other as directories — `[spec](../spec)`,
 * 428 of them — and TypeDoc registers every relative link target as a media
 * "file". typedoc-plugin-markdown's copyMediaFiles then recursively copies
 * each entry; copying a package DIRECTORY descends into node_modules, where
 * pnpm's workspace symlinks for the cyclic optional-peer pair
 * (@agentick/code ⇄ @agentick/code-host) loop until ENAMETOOLONG kills the
 * build. A directory was never a valid media file — remove them all here.
 */

import * as fs from "node:fs";
import { RendererEvent } from "typedoc";

export function load(app) {
  app.renderer.on(RendererEvent.BEGIN, (event) => {
    const files = event.project.files;
    let dropped = 0;
    for (const [id, absolute] of [...files.mediaToPath.entries()]) {
      let keep = false;
      try {
        keep = fs.statSync(absolute).isFile();
      } catch {
        keep = false;
      }
      if (!keep) {
        files.mediaToPath.delete(id);
        files.names.delete(id);
        files.pathToMedia.delete(absolute);
        dropped++;
      }
    }
    if (dropped > 0) {
      app.logger.info(`media-guard: dropped ${dropped} non-file media entries (directory links)`);
    }
  });
}
