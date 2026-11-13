import { external_api } from "@/lib/api";
import { RTTEX } from "@/lib/rttex";
import { cropTileFromAtlas } from "@/lib/utils";

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
  private tiles = new Map<string, TileEntry>();
  private cacheApi: Cache | null = null;

  private async getCacheApi(): Promise<Cache> {
    if (!this.cacheApi) {
      this.cacheApi = await caches.open("texture-cache");
    }
    return this.cacheApi;
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
    const cachedResponse = await cache.match(cacheKey);

    let pngBlob: Blob;

    if (cachedResponse) {
      pngBlob = await cachedResponse.blob();
    } else {
      const rttexBlob = await external_api.stiledevs.getGameTextureAssets(
        textureFileName
      );

      const arrayBuffer = await rttexBlob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      const pngData = await RTTEX.decode(uint8Array);
      // @ts-expect-error idk but it works
      pngBlob = new Blob([pngData.buffer], { type: "image/png" });

      await cache.put(cacheKey, new Response(pngBlob.slice()));
    }

    const objectUrl = URL.createObjectURL(pngBlob);

    return {
      blob: pngBlob,
      objectUrl,
      refCount: 0,
    };
  }

  async getCroppedTile(
    textureFileName: string,
    textureX: number,
    textureY: number
  ): Promise<string> {
    const tileKey = `${textureFileName}:${textureX}:${textureY}`;

    const cached = this.tiles.get(tileKey);
    if (cached) {
      cached.refCount++;
      return cached.objectUrl;
    }

    const textureEntry = await this.getTexture(textureFileName);
    textureEntry.refCount++;

    const croppedUrl = await cropTileFromAtlas(
      textureEntry.objectUrl,
      textureX,
      textureY
    );

    const tileEntry: TileEntry = {
      objectUrl: croppedUrl,
      refCount: 1,
    };
    this.tiles.set(tileKey, tileEntry);

    return croppedUrl;
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

    if (tileEntry) {
      tileEntry.refCount--;
      if (tileEntry.refCount <= 0) {
        URL.revokeObjectURL(tileEntry.objectUrl);
        this.tiles.delete(tileKey);
      }
    }

    const textureEntry = this.textures.get(textureFileName);
    if (textureEntry) {
      textureEntry.refCount--;
      if (textureEntry.refCount <= 0) {
        setTimeout(() => {
          const entry = this.textures.get(textureFileName);
          if (entry && entry.refCount <= 0) {
            URL.revokeObjectURL(entry.objectUrl);
            this.textures.delete(textureFileName);
          }
        }, 10000);
      }
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
    if (existing) {
      existing.refCount++;
      return existing.objectUrl;
    }

    try {
      const texture = await this.getTexture(textureFileName);
      const bitmap = await createImageBitmap(texture.blob);
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close();
        return null;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      bitmap.close();

      const croppedBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((blob) => resolve(blob), "image/png"),
      );
      if (!croppedBlob) return null;

      const objectUrl = URL.createObjectURL(croppedBlob);
      this.tiles.set(cacheKey, { objectUrl, refCount: 1 });
      return objectUrl;
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
      URL.revokeObjectURL(entry.objectUrl);
    }
    this.tiles.clear();

    for (const entry of this.textures.values()) {
      URL.revokeObjectURL(entry.objectUrl);
    }
    this.textures.clear();
    this.loadingTextures.clear();

    const cache = await this.getCacheApi();
    const keys = await cache.keys();
    await Promise.all(keys.map((key) => cache.delete(key)));
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
