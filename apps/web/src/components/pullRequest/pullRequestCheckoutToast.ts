export function offHeadPullRequestCheckoutToast() {
  return {
    type: "warning",
    title: "Checked out, but not confirmed on the latest commit",
    description: "Local commits or uncommitted changes can keep the checkout on an earlier commit.",
  } as const;
}
