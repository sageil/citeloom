export interface Deferred<Value = void> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

export function createDeferred<Value = void>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: Value): void => resolvePromise(value),
  };
}
