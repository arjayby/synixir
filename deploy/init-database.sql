\getenv synixir_password SYNIXIR_DATABASE_PASSWORD
CREATE ROLE synixir LOGIN PASSWORD :'synixir_password';
CREATE DATABASE synixir OWNER synixir;
