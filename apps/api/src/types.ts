export interface AppUser {
  id: string;
  name: string;
  email: string;
}

export type AppEnv = {
  Variables: {
    user: AppUser;
  };
};
