export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export const assert = (value: unknown, code: string, message: string, status = 400): asserts value => {
  if (!value) throw new ApiError(status, code, message);
};
