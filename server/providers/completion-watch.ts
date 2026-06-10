export function watchProviderCompletion(
  completion: Promise<unknown>,
  onSettled: () => void,
): void {
  // The owning controller/run path handles completion failures. This detached
  // watcher only observes settlement so runtime references can be cleared.
  void completion.catch(() => undefined).finally(onSettled);
}
