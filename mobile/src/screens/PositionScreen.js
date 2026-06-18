import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, StyleSheet, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { db } from '../services/firebase';
import { ref, onValue, set } from 'firebase/database';

export default function PositionScreen() {
  const [positions, setPositions] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [activeAirline, setActiveAirline] = useState('jetblue');

  useEffect(() => {
    const posRef = ref(db, 'positions');
    onValue(posRef, (snapshot) => {
      if (snapshot.exists()) {
        setPositions(snapshot.val());
      }
    });
  }, []);

  const JETBLUE_ROLES = [
    "supervisor", "documento", "5x5", "makeup", "sello", "observer_makeup",
    "puerta_delantera", "puerta_trasera", "observer_rampa", "rampa_delantera", "rampa_trasera"
  ];

  const WESTJET_ROLES = [
    "supervisor", "documento_1", "documento_2", "5x5", "makeup", "sello",
    "puerta_delantera", "puerta_trasera", "rampa_delantera", "rampa_trasera"
  ];

  const handleUpdate = (roleKey, name) => {
    const roleRef = ref(db, `positions/${roleKey}`);
    set(roleRef, name);
  };

  const currentRoles = activeAirline === 'jetblue' ? JETBLUE_ROLES : WESTJET_ROLES;
  const suffix = activeAirline === 'jetblue' ? '' : '_west'; // Simplified matching

  return (
    <View style={styles.container}>
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tab, activeAirline === 'jetblue' && styles.activeTab]}
          onPress={() => setActiveAirline('jetblue')}
        >
          <Text style={[styles.tabText, activeAirline === 'jetblue' && styles.activeTabText]}>JETBLUE</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeAirline === 'westjet' && styles.activeTab]}
          onPress={() => setActiveAirline('westjet')}
        >
          <Text style={[styles.tabText, activeAirline === 'westjet' && styles.activeTabText]}>WESTJET</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {currentRoles.map((role) => {
          const fullKey = role + suffix;
          return (
            <View key={fullKey} style={styles.roleCard}>
              <Text style={styles.roleLabel}>{role.replace(/_/g, ' ').toUpperCase()}</Text>
              <TextInput
                style={styles.input}
                value={positions[fullKey] || ''}
                onChangeText={(text) => handleUpdate(fullKey, text)}
                placeholder="Nombre del personal"
                placeholderTextColor="#64748b"
              />
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    padding: 10,
  },
  tab: {
    flex: 1,
    padding: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  activeTab: {
    backgroundColor: '#38bdf8',
  },
  tabText: {
    color: '#94a3b8',
    fontWeight: 'bold',
  },
  activeTabText: {
    color: '#fff',
  },
  scrollContent: {
    padding: 15,
  },
  roleCard: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 15,
    marginBottom: 12,
  },
  roleLabel: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#0f172a',
    color: '#fff',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
});
