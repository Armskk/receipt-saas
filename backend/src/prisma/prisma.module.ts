import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// @Global so every feature module can inject PrismaService without each one
// importing PrismaModule explicitly.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
