import { external_api } from "@/lib/api";
import { RTTEX } from "@/lib/rttex";

interface TextureEntry {
  blob: Blob;
  objectUrl: string;
  refCount: number;
}

interface TileEntry {
  objectUrl: string;
  refCount: number;
}

class TextureCacheManager {
  private loadingTextures = new Map<string, Promise<TextureEntry>>();
  private textures = new Map<string, TextureEntry>();
  private loadingBitmaps = new Map<string, Promise<ImageBitmap>>();
  private bitmaps = new Map<string, ImageBitmap>();
  private tiles = new Map<string, TileEntry>();
  private cacheApi: Cache | null | undefined = undefined;

  private async getCacheApi(): Promise<Cache | null> {
    if (this.cacheApi !== undefined) {
      return this.cacheApi;
    }
    try {
      if (typeof caches !== "undefined" && typeof caches.open === "function") {
        this.cacheApi = await caches.open("texture-cache");
        return this.cacheApi;
      }
    } catch {
      // Cache API is unavailable on non-secure origins (e.g. plain HTTP LAN IPs)
    }
    this.cacheApi = null;
    return null;
  }

  private async getTexture(textureFileName: string): Promise<TextureEntry> {
    const cached = this.textures.get(textureFileName);
    if (cached) {
      return cached;
    }

    const loading = this.loadingTextures.get(textureFileName);
    if (loading) {
      return loading;
    }

    const loadPromise = this._loadTexture(textureFileName);
    this.loadingTextures.set(textureFileName, loadPromise);

    try {
      const entry = await loadPromise;
      this.textures.set(textureFileName, entry);
      return entry;
    } finally {
      this.loadingTextures.delete(textureFileName);
    }
  }

  private async _loadTexture(textureFileName: string): Promise<TextureEntry> {
    const cache = await this.getCacheApi();
    const cacheKey = `https://texture-cache.local/v2/${textureFileName}`;
    const cachedResponse = cache ? await cache.match(cacheKey).catch(() => undefined) : undefined;

    let pngBlob: Blob | null = null;

    if (cachedResponse) {
      const candidate = await cachedResponse.blob();
      if (candidate.size > 0) {
        pngBlob = candidate;
      } else if (cache) {
        await cache.delete(cacheKey).catch(() => {});
      }
    }

    if (!pngBlob) {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const rttexBlob = await external_api.stiledevs.getGameTextureAssets(
            textureFileName
          );
          const arrayBuffer = await rttexBlob.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          if (uint8Array.byteLength < 6) {
            throw new Error(`Empty texture payload for ${textureFileName}`);
          }
          const pngData = await RTTEX.decode(uint8Array);
          // @ts-expect-error idk but it works
          pngBlob = new Blob([pngData.buffer], { type: "image/png" });
          if (cache) {
            await cache.put(cacheKey, new Response(pngBlob.slice())).catch(() => {});
          }
          break;
        } catch (err) {
          lastError = err;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 250 * attempt));
          }
        }
      }
      if (!pngBlob) {
        throw lastError instanceof Error
          ? lastError
          : new Error(`Failed to load texture ${textureFileName}`);
      }
    }

    const objectUrl = URL.createObjectURL(pngBlob);

    return {
      blob: pngBlob,
      objectUrl,
      refCount: 0,
    };
  }

  /**
   * Decode and cache an `ImageBitmap` for a `.rttex` sheet once in memory so every
   * tile crop and Pixi GPU `ImageSource` slices instantaneously without re-decoding the sheet.
   */
  async getSheetBitmap(textureFileName: string): Promise<ImageBitmap> {
    const normalizedName = textureFileName.replace(/^game\//i, "").trim();
    const existing = this.bitmaps.get(normalizedName);
    if (existing) {
      return existing;
    }

    const inFlight = this.loadingBitmaps.get(normalizedName);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const entry = await this.getTexture(normalizedName);
      const bmp = await createImageBitmap(entry.blob);
      this.bitmaps.set(normalizedName, bmp);
      return bmp;
    })();

    this.loadingBitmaps.set(normalizedName, promise);
    try {
      return await promise;
    } finally {
      this.loadingBitmaps.delete(normalizedName);
    }
  }

  /** Preload and decode a batch of `.rttex` sheet bitmaps; returns set of successfully loaded names. */
  async preloadSheetBitmaps(textureFileNames: string[]): Promise<Set<string>> {
    const unique = Array.from(new Set(textureFileNames.filter(Boolean)));
    const loaded = new Set<string>();
    await Promise.all(
      unique.map(async (name) => {
        try {
          await this.getSheetBitmap(name);
          loaded.add(name);
        } catch {
          // Leave missing from `loaded` so callers can retry later
        }
      })
    );
    return loaded;
  }

  async getCroppedTile(
    textureFileName: string,
    textureX: number,
    textureY: number
  ): Promise<string> {
    const normalizedName = textureFileName.replace(/^game\//i, "").trim();
    const tileKey = `${normalizedName}:${textureX}:${textureY}`;

    const cached = this.tiles.get(tileKey);
    if (cached && cached.objectUrl) {
      cached.refCount++;
      return cached.objectUrl;
    }

    const isLongHand = /^player_longhanditem\d*\.rttex$/i.test(normalizedName);
    const cellW = isLongHand ? 64 : 32;
    const cellH = 32;

    const bitmap = await this.getSheetBitmap(normalizedName);
    const canvas = document.createElement("canvas");
    canvas.width = cellW;
    canvas.height = cellH;
    const ctx = canvas.getContext("2d");
    if (ctx && textureX >= 0 && textureY >= 0) {
      const cols = Math.max(1, Math.floor(bitmap.width / cellW));
      const rows = Math.max(1, Math.floor(bitmap.height / cellH));
      if (textureX < cols && textureY < rows) {
        const sx = textureX * cellW;
        const sy = textureY * cellH;
        const cw = Math.max(0, Math.min(cellW, bitmap.width - sx));
        const ch = Math.max(0, Math.min(cellH, bitmap.height - sy));
        if (cw > 0 && ch > 0) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(bitmap, sx, sy, cw, ch, 0, 0, cw, ch);
        }
      }
    }

    const dataUrl = canvas.toDataURL("image/png");
    this.tiles.set(tileKey, { objectUrl: dataUrl, refCount: 1 });
    return dataUrl;
  }

  private itemIcons = new Map<string, string>();

  /**
   * Decode/cache a single item icon trimmed to its non-transparent bounds and centered
   * proportionally onto a crisp 32x32 canvas (prevents flat wearables like Jeans from rendering
   * as tiny bottom strips).
   */
  async getCroppedItemIcon(
    textureFileName: string,
    textureX: number,
    textureY: number
  ): Promise<string> {
    const iconKey = `${textureFileName}:${textureX}:${textureY}`;
    const existing = this.itemIcons.get(iconKey);
    if (existing) return existing;

    const rawUrl = await this.getCroppedTile(textureFileName, textureX, textureY);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Failed to load cropped item icon'));
        el.src = rawUrl;
      });
      const w = img.width || 32;
      const h = img.height || 32;
      const scanCanvas = document.createElement('canvas');
      scanCanvas.width = w;
      scanCanvas.height = h;
      const sctx = scanCanvas.getContext('2d');
      if (!sctx) return rawUrl;
      sctx.drawImage(img, 0, 0);
      const data = sctx.getImageData(0, 0, w, h).data;

      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX < minX || maxY < minY) {
        this.itemIcons.set(iconKey, rawUrl);
        return rawUrl;
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      // Full-sized blocks (e.g. Dirt/Rock 32x32) already fill the cell cleanly
      if (bw >= 26 && bh >= 26) {
        this.itemIcons.set(iconKey, rawUrl);
        return rawUrl;
      }

      const out = document.createElement('canvas');
      out.width = 32;
      out.height = 32;
      const octx = out.getContext('2d');
      if (!octx) return rawUrl;
      octx.imageSmoothingEnabled = false;

      // Scale smaller/flat wearables (like 20x6 Jeans) cleanly to ~26px span, centered
      const scale = Math.min(3.2, 26 / Math.max(bw, bh));
      const dw = Math.max(1, Math.round(bw * scale));
      const dh = Math.max(1, Math.round(bh * scale));
      const dx = Math.round((32 - dw) / 2);
      const dy = Math.round((32 - dh) / 2);

      octx.drawImage(img, minX, minY, bw, bh, dx, dy, dw, dh);
      const dataUrl = out.toDataURL('image/png');
      this.itemIcons.set(iconKey, dataUrl);
      return dataUrl;
    } catch {
      return rawUrl;
    }
  }

  releaseTile(
    textureFileName: string,
    textureX: number,
    textureY: number
  ): void {
    const tileKey = `${textureFileName}:${textureX}:${textureY}`;
    const tileEntry = this.tiles.get(tileKey);
    if (tileEntry && tileEntry.refCount > 0) {
      tileEntry.refCount--;
    }
    const textureEntry = this.textures.get(textureFileName);
    if (textureEntry && textureEntry.refCount > 0) {
      textureEntry.refCount--;
    }
  }

  /** Crop an arbitrary rectangular pixel region `(sx, sy, sw, sh)` from a cached `.rttex` asset. */
  async getCroppedRegion(
    textureFileName: string,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): Promise<string | null> {
    const cacheKey = `${textureFileName}:reg:${sx},${sy},${sw},${sh}`;
    const existing = this.tiles.get(cacheKey);
    if (existing && existing.objectUrl) {
      existing.refCount++;
      return existing.objectUrl;
    }

    try {
      const bitmap = await this.getSheetBitmap(textureFileName);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, sw);
      canvas.height = Math.max(1, sh);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = false;
      const clampedW = Math.max(0, Math.min(sw, bitmap.width - sx));
      const clampedH = Math.max(0, Math.min(sh, bitmap.height - sy));
      if (sx >= 0 && sy >= 0 && clampedW > 0 && clampedH > 0) {
        ctx.drawImage(bitmap, sx, sy, clampedW, clampedH, 0, 0, clampedW, clampedH);
      }

      const dataUrl = canvas.toDataURL("image/png");
      this.tiles.set(cacheKey, { objectUrl: dataUrl, refCount: 1 });
      return dataUrl;
    } catch {
      return null;
    }
  }

  /** Return the decoded PNG object URL for a full `.rttex` sprite sheet. */
  async getFullTextureUrl(textureFileName: string): Promise<string | null> {
    try {
      const texture = await this.getTexture(textureFileName);
      return texture.objectUrl;
    } catch {
      return null;
    }
  }

  async clearAll(): Promise<void> {
    for (const entry of this.tiles.values()) {
      if (entry.objectUrl.startsWith("blob:")) {
        URL.revokeObjectURL(entry.objectUrl);
      }
    }
    this.tiles.clear();
    this.itemIcons.clear();

    for (const bmp of this.bitmaps.values()) {
      bmp.close();
    }
    this.bitmaps.clear();
    this.loadingBitmaps.clear();

    for (const entry of this.textures.values()) {
      URL.revokeObjectURL(entry.objectUrl);
    }
    this.textures.clear();
    this.loadingTextures.clear();

    const cache = await this.getCacheApi();
    if (cache) {
      const keys = await cache.keys();
      await Promise.all(keys.map((key) => cache.delete(key)));
    }
  }

  async batchLoadTiles(
    requests: Array<{ textureFileName: string; textureX: number; textureY: number }>,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string[]> {
    const results: string[] = new Array(requests.length);
    let loadedCount = 0;

    const byTexture = new Map<string, Array<{ index: number; x: number; y: number }>>();
    
    requests.forEach((req, index) => {
      const key = req.textureFileName;
      if (!byTexture.has(key)) {
        byTexture.set(key, []);
      }
      byTexture.get(key)!.push({ index, x: req.textureX, y: req.textureY });
    });

    const texturePromises = Array.from(byTexture.entries()).map(async ([textureFileName, tiles]) => {
      
      const tilePromises = tiles.map(async ({ index, x, y }) => {
        try {
          const url = await this.getCroppedTile(textureFileName, x, y);
          results[index] = url;
        } catch (error) {
          results[index] = '';
        }
        
        loadedCount++;
        onProgress?.(loadedCount, requests.length);
      });

      await Promise.all(tilePromises);
    });

    await Promise.all(texturePromises);
    return results;
  }

  async preloadTextures(textureFileNames: string[]): Promise<void> {
    const promises = textureFileNames.map(fileName => this.getTexture(fileName));
    await Promise.all(promises);
  }
}

export const textureCacheManager = new TextureCacheManager();
