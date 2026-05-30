import { withAnimaHome as withScopedAnimaHome } from '../anima-home.js';

export async function withAnimaHome<T>(dir: string, body: () => Promise<T>): Promise<T> {
  return withScopedAnimaHome(dir, body);
}
