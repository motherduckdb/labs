import { FC } from 'react';
import styles from './styles.module.css';

export const LoadingSpinner: FC<{ message?: string }> = ({ message = 'Setting up database connection...' }) => (
  <div className={styles.container}>
    <div className={styles.loadingContainer}>
      <div className={styles.spinner} />
      <span>{message}</span>
    </div>
  </div>
);
