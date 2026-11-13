export class RPCFile {
  Name: string;
  Content?: BodyInit;

  constructor(name = "", content?: BodyInit) {
    this.Name = name;
    this.Content = content;
  }
}
