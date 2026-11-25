export class InvalidParams extends Error {}

export class PolicyError extends InvalidParams {
  get data() { return { reason: this.message }; }
}

export function policyCheck(check) {
  try {
    return check();
  } catch (error) {
    throw new PolicyError(error.message);
  }
}
