import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireEnv } from '../common/env';

export interface JwtPayload {
  sub: string; // userId
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireEnv('JWT_SECRET'),
    });
  }

  // Whatever this returns becomes `req.user` in guarded routes.
  async validate(payload: JwtPayload) {
    return { userId: payload.sub, email: payload.email };
  }
}
