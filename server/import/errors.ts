export class ImportError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'validation',
  ) {
    super(message);
  }
}
