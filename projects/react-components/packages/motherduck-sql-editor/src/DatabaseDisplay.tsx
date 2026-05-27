import { FC } from 'react';
import styles from './styles.module.css';

export const DatabaseDisplay: FC<{ database: string }> = ({ database }) => (
  <div className={styles.databaseDisplay}>
    <span className={styles.databaseLabel}>Active Database:</span>
    <code className={styles.databaseCode}>{database}</code>
  </div>
);
