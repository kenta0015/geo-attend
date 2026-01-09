import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { supabase } from "./supabase";

type PickResult = {
  uri: string;
  width: number;
  height: number;
};

export async function pickAvatarFromLibrary(): Promise<PickResult | null> {
  try {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });

    // Support both old and new result shapes
    const canceled = (res as any).cancelled ?? (res as any).canceled;
    if (canceled) return null;

    const asset = (res as any).assets ? (res as any).assets[0] : res;
    if (!asset || !asset.uri) return null;

    return { uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 };
  } catch (e) {
    console.log("avatar pickAvatarFromLibrary exception:", e);
    return null;
  }
}

export async function takeAvatarPhoto(): Promise<PickResult | null> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (permission.status !== "granted") return null;

    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });

    const canceled = (res as any).cancelled ?? (res as any).canceled;
    if (canceled) return null;

    const asset = (res as any).assets ? (res as any).assets[0] : res;
    if (!asset || !asset.uri) return null;

    return { uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 };
  } catch (e) {
    console.log("avatar takeAvatarPhoto exception:", e);
    return null;
  }
}

export async function processToSquare512Jpeg(input: {
  uri: string;
  width: number;
  height: number;
}): Promise<string> {
  const { uri, width, height } = input;

  try {
    // If width/height is unavailable, avoid crop math and just compress/resize safely.
    // (This keeps the image usable instead of producing a 1x1 crop.)
    if (!width || !height || width <= 0 || height <= 0) {
      const fallback = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: 512 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );
      return fallback.uri;
    }

    const size = Math.min(width, height);
    const rawCropX = Math.floor((width - size) / 2);
    const rawCropY = Math.floor((height - size) / 2);

    // Clamp to non-negative to prevent invalid crop origins.
    const cropX = Math.max(0, rawCropX);
    const cropY = Math.max(0, rawCropY);

    const actions: ImageManipulator.Action[] = [
      { crop: { originX: cropX, originY: cropY, width: size, height: size } },
      { resize: { width: 512, height: 512 } },
    ];

    const result = await ImageManipulator.manipulateAsync(uri, actions, {
      compress: 0.8,
      format: ImageManipulator.SaveFormat.JPEG,
    });

    return result.uri;
  } catch (e) {
    console.log("avatar processToSquare512Jpeg exception:", e);
    return uri;
  }
}

export async function uploadAvatarForUser(
  userId: string,
  processedUri: string
): Promise<string | null> {
  try {
    const objectName = `${userId}/${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
    console.log("avatar upload objectName:", objectName);
    console.log("avatar upload processedUri:", processedUri);

    // Avoid data: URL fetch; fetch the file:// URI directly (more reliable in RN/Expo)
    console.log("avatar reading file via fetch(fileUri)...");
    const fileRes = await fetch(processedUri);
    const arrayBuffer = await fileRes.arrayBuffer();
    console.log("avatar arrayBuffer byteLength:", arrayBuffer.byteLength);

    const bytes = new Uint8Array(arrayBuffer);

    console.log("avatar uploading to storage...");
    const { error: uploadError } = await supabase.storage.from("avatars").upload(objectName, bytes, {
      contentType: "image/jpeg",
      upsert: true,
    });
    console.log("avatar uploadError:", uploadError);

    if (uploadError) return null;

    console.log("avatar updating user_profile...");
    const update = await supabase
      .from("user_profile")
      .update({ avatar_path: objectName, avatar_updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    console.log("avatar updateError:", update.error);

    if (update.error) {
      // Attempt to remove uploaded file if DB update failed
      try {
        console.log("avatar DB update failed; removing uploaded object:", objectName);
        await supabase.storage.from("avatars").remove([objectName]);
      } catch (e) {
        console.log("avatar rollback remove exception:", e);
      }
      return null;
    }

    console.log("avatar upload succeeded:", objectName);
    return objectName;
  } catch (e) {
    console.log("avatar uploadAvatarForUser exception:", e);
    return null;
  }
}

export async function removeAvatarForUser(
  userId: string,
  currentAvatarPath: string | null
): Promise<boolean> {
  try {
    console.log("avatar removeAvatarForUser userId:", userId, "currentAvatarPath:", currentAvatarPath);

    if (currentAvatarPath) {
      const { error: removeError } = await supabase.storage.from("avatars").remove([currentAvatarPath]);
      console.log("avatar remove storage error:", removeError);
    }

    const update = await supabase
      .from("user_profile")
      .update({ avatar_path: null, avatar_updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    console.log("avatar remove updateError:", update.error);

    if (update.error) return false;
    return true;
  } catch (e) {
    console.log("avatar removeAvatarForUser exception:", e);
    return false;
  }
}

export default {
  pickAvatarFromLibrary,
  takeAvatarPhoto,
  processToSquare512Jpeg,
  uploadAvatarForUser,
  removeAvatarForUser,
};
