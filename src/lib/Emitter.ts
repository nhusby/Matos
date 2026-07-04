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

  emit<K extends keyof T>(event: K, arg: T[K]): boolean;
  emit(event: string | symbol, ...values: any[]): boolean;
  emit(event: string | symbol, ...values: any[]): boolean {
    return super.emit(event, ...values);
  }

  emitAsync<K extends keyof T>(event: K, arg: T[K]): Promise<any[]>;
  emitAsync(event: string | symbol, ...values: any[]): Promise<any[]>;
  emitAsync(event: string | symbol, ...values: any[]): Promise<any[]> {
    return super.emitAsync(event, ...values);
  }

  /**
   * Pipes the argument through listeners in order. If a listener returns
   * a value (not undefined), it replaces the argument for the next listener.
   */
  protected async emitReplace<K extends keyof T>(
    event: K,
    arg: T[K],
  ): Promise<[T[K]]> {
    const list = this.listeners(event as string) as Array<(arg: T[K]) => any>;
    let value = arg;
    for (const listener of list) {
      const result = await listener(value);
      if (result !== undefined) {
        value = result;
      }
    }
    return [value];
  }
}
