/** 0 to 4, from length and character variety. A hint for the form, not a guarantee. */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (password.length < 8) return password.length === 0 ? 0 : 1;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const score = (password.length >= 12 ? 2 : 1) + (classes >= 3 ? 1 : 0) + (password.length >= 16 ? 1 : 0);
  return Math.min(4, Math.max(1, score)) as 1 | 2 | 3 | 4;
}
