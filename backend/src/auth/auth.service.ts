import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto, SignUpDto } from './dto/auth.dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async signUp(dto: SignUpDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // A new sign-up creates their first workspace as OWNER. Joining an
    // existing workspace later is a separate invite flow — not scaffolded
    // here yet.
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        name: dto.name,
        memberships: {
          create: {
            role: 'OWNER',
            workspace: { create: { name: dto.workspaceName } },
          },
        },
      },
      include: { memberships: true },
    });

    return this.issueToken(user.id, user.email);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.issueToken(user.id, user.email);
  }

  private issueToken(userId: string, email: string) {
    const accessToken = this.jwt.sign({ sub: userId, email });
    return { accessToken };
  }
}
