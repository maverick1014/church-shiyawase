import {
  IsEmail,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import { ChurchRole, Gender, GroupPosition, MemberStatus } from '@tog/shared';

export class CreateMemberDto {
  @IsString()
  @MaxLength(200)
  full_name!: string;

  // Renamed with the column in 0018: this field has always held the English
  // name, so a DTO that still said `chinese_name` would write into a column
  // that no longer exists.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  english_name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @IsISO8601()
  date_of_birth?: string;

  @IsOptional()
  @IsEnum(ChurchRole)
  church_role?: ChurchRole;

  @IsOptional()
  @IsEnum(MemberStatus)
  status?: MemberStatus;

  @IsOptional()
  @IsUUID()
  group_id?: string;

  @IsOptional()
  @IsEnum(GroupPosition)
  group_position?: GroupPosition;

  @IsOptional()
  @IsUUID()
  household_id?: string;

  @IsOptional()
  @IsISO8601()
  joined_at?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateMemberDto extends PartialType(CreateMemberDto) {}
