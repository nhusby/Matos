import EventEmitter2 from 'eventemitter2';

export class Emitter<T = unknown> extends EventEmitter2 {
  readonly abortController = new AbortController();

  constructor() {
    super({ ignoreErrors: true });
  }

  abort() {
    this.abortController.abort();
  }

  toPromise<R = any>(): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.once('error', reject);
      this.once('aborted', () =>
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
      );
      this.once('end', (value: R) => resolve(value));
    });
  }

  on<K extends keyof T>(event: K, listener: (arg: T[K]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener) as this;
  }

  once<K extends keyof T>(event: K, listener: (arg: T[K]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener) as this;
  }

  /**
   * Notifies onAny listeners with (event, arg), then pipes arg through event
   * listeners sequentially. A listener returning a non-undefined value
   * replaces the arg for subsequent listeners and becomes the return value.
   * Arg is optional for void events.
   */
  // @ts-expect-error - intentionally returns Promise<T> instead of boolean
  emit<K extends keyof T>(...args: T[K] extends void ? [event: K] : [event: K, arg: T[K]]): Promise<T[K]>;
  // @ts-expect-error - intentionally returns Promise<T> instead of boolean
  emit(event: string | symbol, arg?: any): Promise<any>;
  // @ts-expect-error - intentionally returns Promise<T> instead of boolean
  async emit(event: string | symbol, arg?: any): Promise<any> {
    const all = (this as any)._all as Array<(event: any, arg: any) => any> | undefined;
    if (all) {
      for (const fn of all) {
        await fn(event, arg);
      }
    }
    const ls = ((this.listeners(event) as any[]) || []).slice() as Array<(arg: any) => any>;
    let value = arg;
    for (const listener of ls) {
      const result = await listener(value);
      if (result !== undefined) {
        value = result;
      }
    }
    return value;
  }
}
