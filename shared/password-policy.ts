/** 新设密码的规则，前后端共用。只在建号、申请、改密时检查，已有密码照常能登录。 */
export const PASSWORD_MAX_LENGTH = 128;
export const passwordHint = '至少 8 位，要有大写和小写字母';
/** 给输入框的 pattern 用，和 passwordAllowed 保持一致。 */
export const passwordPattern = '(?=.*[a-z])(?=.*[A-Z]).{8,128}';

export function passwordAllowed(password: string) {
  return (
    password.length >= 8 &&
    password.length <= PASSWORD_MAX_LENGTH &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password)
  );
}
