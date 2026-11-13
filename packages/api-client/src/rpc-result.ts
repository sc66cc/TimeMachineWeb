export class RPCResult<T = void> {
  Code: number;
  Message: string;
  Data?: T;

  constructor(code: number, message: string, data: T | undefined) {
    this.Code = code;
    this.Message = message;
    this.Data = data;
  }
}
