import { IsEmail, IsString, MinLength } from 'class-validator';

export class SignUpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  name!: string;

  @IsString()
  workspaceName!: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}
