import { supabase } from "./supabase";

type CacheEntry = {
  url: string;
  expiresAt: number; // ms since epoch
};

const cache = new Map<string, CacheEntry>();
const SIGNED_URL_TTL_SECONDS = 3600;
const SIGNED_URL_TTL_MS = SIGNED_URL_TTL_SECONDS * 1000;
// Per request: if cached and remaining TTL > 5,601,000 ms, return cached
const MIN_TTL_MS = 5 * 60 * 1000
;

export async function getAvatarSignedUrl(
  avatarPath: string | null
): Promise<string | null> {
  if (!avatarPath) return null;

  const now = Date.now();
  const cached = cache.get(avatarPath);
  if (cached && cached.expiresAt - now > MIN_TTL_MS) {
    return cached.url;
  }

  try {
    const { data, error } = await supabase.storage
      .from("avatars")
      .createSignedUrl(avatarPath, SIGNED_URL_TTL_SECONDS as number);

    if (error || !data) return null;

    // supabase may return signed URL in different keys depending on client version
    const anyData: any = data as any;
    const url: string | undefined =
      anyData.signedUrl ?? anyData.signedURL ?? anyData.signed_url ?? anyData.signedUrl;

    if (!url) return null;

    const expiresAt = now + SIGNED_URL_TTL_MS;
    cache.set(avatarPath, { url, expiresAt });
    return url;
  } catch (e) {
    return null;
  }
}

export default getAvatarSignedUrl;

