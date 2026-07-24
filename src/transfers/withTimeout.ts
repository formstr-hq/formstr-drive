export class TransferFailure extends Error {
  code: string;
  detail?: any;
  constructor(code: string, message: string, detail?: any) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  code: string,
  message?: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TransferFailure(code, message || `Operation timed out after ${ms}ms`));
    }, ms);

    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
