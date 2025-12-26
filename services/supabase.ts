
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vydymilnflhahyblpfcv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5ZHltaWxuZmxoYWh5YmxwZmN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYyNzAwMjUsImV4cCI6MjA4MTg0NjAyNX0.Vdp_Ui6DBgAjq5WFYtuXKL_JZAyU9QxBq5KReubt5Xc';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
