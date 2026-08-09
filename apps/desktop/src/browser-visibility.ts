export type NativeVisibilityPlan = "hide-now" | "sync-bounds-before-show";

export function planNativeVisibility(
  shouldShow: boolean,
): NativeVisibilityPlan {
  return shouldShow ? "sync-bounds-before-show" : "hide-now";
}
