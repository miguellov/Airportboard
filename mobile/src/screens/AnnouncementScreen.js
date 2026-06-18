import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, StyleSheet, Switch, TouchableOpacity, Alert } from 'react-native';
import { db } from '../services/firebase';
import { ref, onValue, set } from 'firebase/database';

export default function AnnouncementScreen() {
  const [announcements, setAnnouncements] = useState([]);
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    const visibilityRef = ref(db, 'visibility/anuncios');
    onValue(visibilityRef, (snapshot) => {
      setIsActive(snapshot.val() !== false);
    });

    const anunciosRef = ref(db, 'anuncios');
    onValue(anunciosRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        const list = Object.entries(data).map(([key, value]) => ({
          id: key,
          ...value,
        }));
        setAnnouncements(list);
      }
    });
  }, []);

  const toggleVisibility = (value) => {
    set(ref(db, 'visibility/anuncios'), value);
  };

  const toggleOnScreen = (id, currentStatus) => {
    set(ref(db, `anuncios/${id}/enPantalla`), !currentStatus);
  };

  return (
    <View style={styles.container}>
      <View style={styles.masterToggle}>
        <Text style={styles.toggleLabel}>Mostrar anuncios en pantalla</Text>
        <Switch
          value={isActive}
          onValueChange={toggleVisibility}
          trackColor={{ false: '#334155', true: '#38bdf8' }}
        />
      </View>

      <FlatList
        data={announcements}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{item.texto || item.tipo}</Text>
              <Switch
                value={item.enPantalla !== false}
                onValueChange={() => toggleOnScreen(item.id, item.enPantalla !== false)}
                trackColor={{ false: '#334155', true: '#22c55e' }}
              />
            </View>
            <Text style={styles.cardDetail}>Tipo: {item.tipo}</Text>
            <Text style={styles.cardDetail}>Duración: {item.duracion || 10}s</Text>
          </View>
        )}
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  masterToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#1e293b',
    marginBottom: 10,
  },
  toggleLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  list: {
    padding: 15,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 15,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 5,
  },
  cardTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    flex: 1,
  },
  cardDetail: {
    color: '#94a3b8',
    fontSize: 14,
  },
});
