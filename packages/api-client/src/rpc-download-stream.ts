import type { RPCTransportResponse } from "./rpc-client";
import { RPCResult } from "./rpc-result";

export class RPCDownloadStreamBlob {
  URL = "";
  FileName = "";
}

function fileNameFromDisposition(disposition: string | undefined): string {
  const encoded = disposition?.match(/filename\\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    return decodeURIComponent(encoded);
  }
  return disposition?.match(/filename=\"?([^\";]+)\"?/i)?.[1] ?? "download";
}

export class RPCDownloadStream<T = void> {
  readonly filename: string;
  readonly blob: Blob;

  constructor(response: RPCTransportResponse<unknown>) {
    this.filename = fileNameFromDisposition(
      response.headers["content-disposition"],
    );
    const contentType =
      response.headers["content-type"] ?? "application/octet-stream";
    this.blob =
      response.data instanceof Blob
        ? response.data
        : new Blob([response.data as BlobPart], { type: contentType });
  }

  async getFormatted(): Promise<RPCDownloadStreamBlob | RPCResult<T>> {
    if (this.blob.type.includes("application/octet-stream")) {
      const result = new RPCDownloadStreamBlob();
      result.URL = URL.createObjectURL(this.blob);
      result.FileName = this.filename;
      return result;
    }
    const value = JSON.parse(await this.blob.text()) as RPCResult<T>;
    return new RPCResult(value.Code, value.Message, value.Data);
  }

  GetFormated(): Promise<RPCDownloadStreamBlob | RPCResult<T>> {
    return this.getFormatted();
  }
}
