import { LoginForm } from '../login/form';

export const metadata = { title: 'Create account' };

export default function Signup() {
  return <LoginForm mode="register" />;
}
