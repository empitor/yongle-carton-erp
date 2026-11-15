/** 新设密码的规则，前后端共用。只在建号、申请、改密时检查，已有密码照常能登录。 */
const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const passwordHint = `至少 ${PASSWORD_MIN_LENGTH} 位，要有大写和小写字母`;
/** 给输入框的 pattern 用，和 passwordAllowed 保持一致。 */
export const passwordPattern = `(?=.*[a-z])(?=.*[A-Z]).{${PASSWORD_MIN_LENGTH},${PASSWORD_MAX_LENGTH}}`;

export function passwordAllowed(password: string) {
  return (
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password)
  );
}
