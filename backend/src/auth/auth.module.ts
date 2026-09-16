import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { requireEnv } from '../common/env';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: requireEnv('JWT_SECRET'),
      // `expiresIn` takes an `ms`-style duration string ("7d") or a number of
      // seconds. @nestjs/jwt types it as a template-literal union, so an env
      // string (unknown at compile time) needs the cast.
      signOptions: {
        expiresIn: (process.env.JWT_EXPIRES_IN ?? '7d') as `${number}${'s' | 'm' | 'h' | 'd'}`,
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [JwtModule],
})
export class AuthModule {}
