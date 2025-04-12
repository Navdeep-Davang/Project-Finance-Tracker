import { UserRoleType } from '@shared/schema';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    role: UserRoleType;
  }
}