module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/backend/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    'backend/src/**/*.ts',
    '!backend/src/**/*.test.ts',
    '!backend/src/**/*.d.ts',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/backend/src/$1',
  },
  setupFilesAfterEnv: [],
  testTimeout: 30000,
  // Ignore compiled JS files
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/cdk.out/',
  ],
};