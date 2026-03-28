import EventEmitter2 from 'eventemitter2';

export class EmitterPromise<T> extends EventEmitter2 implements Promise<T> {
  private resolveFn?: (value: T) => void;
  private rejectFn?: (error: Error) => void;
  private promise = new Promise<T>((resolve, reject) => {
    this.resolveFn = resolve;
    this.rejectFn = reject;
  });

  readonly [Symbol.toStringTag] = 'Promise';

  then<TResult1 = T, TResult2 = never>(
    resolve?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    const promise = this.promise.then(resolve, reject) as Promise<T>;

    return Object.setPrototypeOf({ promise }, this) as Promise<
      TResult1 | TResult2
    > &
      EmitterPromise<T>;
  }

  catch<TResult = never>(
    reject?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ) {
    this.promise.catch(reject);

    return this;
  }

  finally(fn?: () => void) {
    this.promise.finally(fn);

    return this;
  }

  resolve(value: T) {
    this.resolveFn?.(value);
  }

  reject(error: Error) {
    this.rejectFn?.(error);
  }
}
