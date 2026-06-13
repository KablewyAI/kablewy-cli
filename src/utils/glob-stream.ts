import { glob, GlobOptions } from 'glob';

export function globStream(pattern: string, options: GlobOptions = {}): AsyncGenerator<string> {
  const stream = glob.stream(pattern, options);
  const iterator = stream[Symbol.asyncIterator]();

  const generator: AsyncGenerator<string> = {
    async next() {
      return iterator.next();
    },
    async return() {
      if (typeof iterator.return === 'function') {
        await iterator.return();
      }
      stream.destroy();
      return { done: true, value: undefined as any };
    },
    async throw(error?: unknown) {
      if (typeof iterator.throw === 'function') {
        await iterator.throw(error);
      }
      stream.destroy(error instanceof Error ? error : undefined);
      throw error;
    },
    [Symbol.asyncIterator]() {
      return generator;
    },
    async [Symbol.asyncDispose]() {
      stream.destroy();
    }
  } as AsyncGenerator<string>;

  return generator;
}
