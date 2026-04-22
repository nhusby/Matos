import EventEmitter2 from 'eventemitter2';

export class Emitter extends EventEmitter2 {
  /**
   * Like emitAsync, but pipes the first argument through listeners in order.
   * Each listener receives (...args). If a listener returns a value
   * (not undefined), it replaces args[0] for the next listener.
   * Returns the final args array.
   */
  protected async emitReplace(
    event: string,
    ...args: any[]
  ): Promise<any[]> {
    const listeners = this.listeners(event) as Array<
      (...args: any[]) => any
    >;
    for (const listener of listeners) {
      const result = await listener(...args);
      if (result !== undefined) {
        args[0] = result;
      }
    }
    return args;
  }
}
